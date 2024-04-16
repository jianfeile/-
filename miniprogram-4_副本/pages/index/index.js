// pages/index/index.js
Page({
  data: {
    // 页面的初始数据
  },
  // 生命周期函数--监听页面加载
  onLoad: function (options) {
    // 页面创建时执行
  },
  // 用户点击“寻找厕所”按钮的事件处理函数
  navigateToSearch: function() {
    wx.navigateTo({
      url: '/pages/findToilet/findToilet' // 更改为你的寻找厕所页面路径
    });
  }
});
